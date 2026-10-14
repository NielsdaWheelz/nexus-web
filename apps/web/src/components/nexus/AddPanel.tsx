"use client";

import { useEffect, useId, useRef, useState, type Ref } from "react";
import { ChevronDown, FileText, Link, Upload, X } from "lucide-react";
import type { FeedbackContent } from "@/components/feedback/Feedback";
import LibraryChooserSurface from "@/components/libraries/LibraryChooserSurface";
import LibraryDestinationPicker from "@/components/libraries/LibraryDestinationPicker";
import LibraryDestinationTrigger from "@/components/libraries/LibraryDestinationTrigger";
import LibraryEntryEditor from "@/components/libraries/LibraryEntryEditor";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { apiTransportFeedback, isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import { getFileUploadKind } from "@/lib/imports/ingest";
import { encodeImportsUrl } from "@/lib/imports/query";
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
import { findAmbiguousUrlSplit, validateDraftSource } from "./addInput";
import {
  MAX_ADD_ITEMS,
  isPopulatedAddItem,
  type AddContentSessionController,
  type AddItem,
  type AddLeaveReason,
  type AddSessionState,
  type PlacementState,
} from "./useAddContentSession";
import styles from "./AddPanel.module.css";

export type AddDismissalConfirmation = {
  kind: NonNullable<AddLeaveReason>;
  actionLabel: string;
} | null;

export function resolveAddPanelInitialFocus(
  container: HTMLElement,
  isMobile: boolean,
): HTMLElement | null {
  const heading = container.querySelector<HTMLElement>('[data-add-heading="true"]');
  return isMobile
    ? heading
    : container.querySelector<HTMLElement>('input[inputmode="url"]:not(:disabled)') ?? heading;
}

/** Normal and defect-boundary dismissal use the same loss contract. */
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
          ? "stop active work?"
          : confirmation?.kind === "Unconfirmed"
            ? "leave with unconfirmed work?"
            : "discard unfinished work?"
      }
      onClose={onKeepWorking}
    >
      {confirmation ? (
        <div className={styles.confirmationBody}>
          <p>
            {confirmation.kind === "Stop"
              ? "some changes may already be saved. stopping will not undo them; unfinished work will be left behind."
              : confirmation.kind === "Unconfirmed"
                ? "some items or library changes may already be saved. leaving loses the requests needed to check or retry them here."
                : "your unsubmitted items will be discarded. saved items will remain."}
          </p>
          <div className={styles.confirmationActions}>
            <Button ref={keepWorkingRef} variant="secondary" size="sm" onClick={onKeepWorking}>
              keep working
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

type Editor = (
  | { kind: "NewItems" | "DraftBulk" }
  | { kind: "Draft"; itemId: string }
  | { kind: "Row"; itemId: string; mediaIds: readonly string[] }
  | { kind: "BulkAdd" | "BulkRemove"; mediaIds: readonly string[] }
) & { anchorEl: HTMLElement };
type EditorError = { content: FeedbackContent; onRetry: (() => void) | null };

type ContentItem = Exclude<AddItem, { kind: "Insertion" }>;

function itemSource(item: ContentItem) {
  return item.kind === "Draft" || item.kind === "Accepted" ? item.source : item.intent.source;
}

function itemLabel(item: ContentItem): string {
  const source = itemSource(item);
  if (source.kind === "Url") return "text" in source ? source.text : source.url;
  return "file" in source ? source.file.name : source.name;
}

function itemStatus(item: AddItem): string | null {
  switch (item.kind) {
    case "Insertion":
    case "Draft":
      return null;
    case "Queued":
      return item.intent.source.kind === "File" ? "preparing…" : "saving…";
    case "Submitting":
      return `${item.phase.toLowerCase()}…`;
    case "Rejected":
      return "not added";
    case "AcceptanceUnresolved":
      return item.reason === "StatusUnknown" ? "acceptance status unknown" : "upload did not complete";
    case "Accepted":
      return item.result.processing === "failed" ? "saved · processing failed" : "saved";
  }
}

/** Inventory remains visible while its placement command changes it. */
function placementLibraries(placement: PlacementState | undefined): readonly LibraryPlacementOption[] {
  switch (placement?.kind) {
    case "Ready":
    case "Updating":
    case "Uncertain":
    case "Refused":
      return placement.libraries;
    case "Loading":
    case "Queued":
      return placementLibraries(placement.previous ?? undefined);
    case undefined:
    case "LoadFailed":
    case "Unavailable":
      return [];
  }
}

function hasUnconfirmedPlacement(placement: PlacementState | undefined): boolean {
  return placement?.kind === "Uncertain"
    || ((placement?.kind === "Loading" || placement?.kind === "Queued") && placement.previous?.kind === "Uncertain");
}

function mutationLabel({ operation, items }: {
  operation: Extract<AddSessionState["mutation"], { kind: "Running" }>["operation"];
  items: readonly AddItem[];
}): string {
  if ((operation.kind === "Submit" && operation.itemIds.length === 1) || operation.kind === "ReconcileAcceptance") {
    const upload = items.find((item) => item.kind === "Submitting" && item.intent.source.kind === "File");
    if (upload?.kind === "Submitting") return `${upload.phase.toLowerCase()}…`;
  }
  switch (operation.kind) {
    case "Submit": return `adding ${pluralize(operation.itemIds.length, "item")}…`;
    case "ReconcileAcceptance": return "checking…";
    case "CreateDestination": return "creating library…";
    case "Placement": return "updating libraries…";
  }
}

function feedbackStatus(feedback: FeedbackContent): string {
  const request = feedback.requestId ? `request id: ${feedback.requestId}` : undefined;
  return [feedback.title, feedback.message, request].filter(Boolean).join(" ");
}

function isFileDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/** One list owns preparation and receipts; all mutations belong to the session. */
export default function AddPanel({
  session,
  mobile,
  dismissalConfirmation,
  onClose,
  onKeepWorking,
  onConfirmDismissal,
  onOpen,
  onDefect,
}: {
  session: AddContentSessionController;
  mobile: boolean;
  dismissalConfirmation: AddDismissalConfirmation;
  onClose(): void;
  onKeepWorking(): void;
  onConfirmDismissal(): void;
  onOpen(target: NexusTarget): void;
  onDefect(error: unknown): void;
}): React.ReactElement {
  const { state } = session;
  const id = useId();
  const operation = state.mutation.kind === "Running" ? state.mutation.operation : null;
  const busy = operation !== null;
  const creatingDestination = operation?.kind === "CreateDestination";
  const drafts = state.items.filter((item) => item.kind === "Draft");
  const validations = new Map(drafts.map((item) => [item.id, validateDraftSource(item.source)]));
  const populatedDrafts = drafts.filter(isPopulatedAddItem);
  const populatedCount = state.items.filter(isPopulatedAddItem).length;
  const full = populatedCount >= MAX_ADD_ITEMS;
  const readyCount = [...validations.values()].filter((result) => result.kind === "Ready").length;
  const accepted = state.items.filter((item) => item.kind === "Accepted");
  const attentionCount = [...validations.values()].filter((result) => result.kind === "Invalid").length
    + state.items.filter((item) => item.kind === "Rejected" || item.kind === "AcceptanceUnresolved").length
    + accepted.filter((item) => hasUnconfirmedPlacement(state.placementByMediaId.get(item.result.mediaId))).length;
  const acceptedMediaIds = [...new Set(accepted.map((item) => item.result.mediaId))];
  const done = accepted.length > 0 && accepted.length === populatedCount && session.leaveReason === null;
  const destinationSets = populatedDrafts.length > 0
    ? populatedDrafts.map((item) => item.destinations)
    : [state.newItemDestinations];
  const coverage = new Map<string, { destination: LibraryDestinationSelection; count: number }>();
  for (const destinations of destinationSets) {
    for (const destination of destinations) {
      coverage.set(destination.id, { destination, count: (coverage.get(destination.id)?.count ?? 0) + 1 });
    }
  }
  const bulkEntries = [...coverage.values()].map(({ destination, count }) => ({
    destination,
    state: count === destinationSets.length ? "All" as const : "Some" as const,
  }));
  const varies = bulkEntries.some((entry) => entry.state === "Some");
  const [dragActive, setDragActive] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [creationError, setCreationError] = useState<EditorError | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chooseFilesRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const keepWorkingRef = useRef<HTMLButtonElement>(null);
  // A close restores its trigger; a retarget or source command owns focus instead.
  const returnFocusAnchor = useRef<HTMLElement | null>(null);
  const panelId = `${id}-libraries`;
  const presentation = mobile ? "Inline" : "Responsive";
  const discloses = mobile ? { kind: "region" as const, id: panelId } : { kind: "dialog" as const };
  const interaction = creatingDestination
    ? { kind: "Creating" as const }
    : busy ? { kind: "Disabled" as const } : { kind: "Enabled" as const };

  useEffect(() => {
    if (dismissalConfirmation) requestAnimationFrame(() => keepWorkingRef.current?.focus());
  }, [dismissalConfirmation]);

  function run(command: () => Promise<void>) {
    setAnnouncement(null);
    void command().catch(onDefect);
  }
  function closeEditor() {
    if (creatingDestination) return;
    setEditor(null);
    setCreationError(null);
  }
  function closeEditorForSource() {
    returnFocusAnchor.current = null;
    closeEditor();
  }
  function toggleEditor(next: Editor) {
    if (creatingDestination) return;
    if (editor?.anchorEl === next.anchorEl) return closeEditor();
    if (busy) return;
    returnFocusAnchor.current = next.anchorEl;
    setCreationError(null);
    setEditor(next);
    if ("mediaIds" in next) run(() => session.refreshPlacements(next.mediaIds));
  }
  function focusSource(itemId: string) {
    requestAnimationFrame(() => {
      const source = listRef.current?.querySelector<HTMLInputElement>(`[data-add-item-id="${itemId}"] input[inputmode="url"]:not(:disabled)`);
      source?.focus();
      source?.setSelectionRange(source.value.length, source.value.length);
    });
  }
  function removeItem(itemId: string) {
    const index = state.items.findIndex((item) => item.id === itemId);
    const candidates = [state.items[index + 1]?.id, state.items[index - 1]?.id, state.items.at(-1)?.id];
    if (editor?.kind === "Draft" && editor.itemId === itemId) closeEditorForSource();
    session.removeItem(itemId);
    setAnnouncement(null);
    requestAnimationFrame(() => {
      for (const candidate of candidates) {
        if (!candidate) continue;
        const row = listRef.current?.querySelector<HTMLElement>(`[data-add-item-id="${candidate}"]`);
        const target = row?.querySelector<HTMLElement>('input[inputmode="url"]:not(:disabled), button:not(:disabled)');
        if (target) return target.focus();
      }
      headingRef.current?.focus();
    });
  }
  function stageFiles(files: readonly File[]) {
    setAnnouncement(null);
    if (session.stageFiles({ files }) && files.length > 0) {
      setAnnouncement(`${pluralize(files.length, "file")} added to the list.`);
    }
  }
  async function createDestination(name: string): Promise<LibraryDestinationSelection> {
    setAnnouncement(null);
    try {
      return await session.createDestination(name);
    } catch (error) {
      if (isLibraryDestinationDefect(error)) onDefect(error);
      throw error;
    }
  }
  async function createAndAdd(name: string, mediaIds: readonly string[]) {
    setAnnouncement(null);
    setCreationError(null);
    try {
      await session.createAndPlace({ name, mediaIds });
    } catch (error) {
      if (isAbortError(error) || handleUnauthenticatedApiError(error)) return;
      try {
        const content = libraryRequestErrorMessage(error, { title: "Library couldn’t be created", request: "LibraryCreate" });
        const retryable = isApiError(error) && apiTransportFeedback(error, content.title) !== null;
        setCreationError({ content, onRetry: retryable ? () => void createAndAdd(name, mediaIds) : null });
      } catch (defect) {
        onDefect(defect);
      }
    }
  }

  const placementEditor = editor && "mediaIds" in editor ? editor : null;
  const editorPlacements = placementEditor?.mediaIds
    .map((mediaId) => state.placementByMediaId.get(mediaId))
    .filter((placement) => placementEditor.kind === "Row" || placement?.kind !== "Unavailable") ?? [];
  const loadingPlacements = editorPlacements.some((placement) => !placement || placement.kind === "Loading" || placement.kind === "Queued");
  const failure = editorPlacements.find((placement) => placement?.kind === "Uncertain")
    ?? editorPlacements.find((placement) => placement?.kind === "LoadFailed" || placement?.kind === "Refused" || placement?.kind === "Unavailable");
  let placementError: EditorError | null = null;
  if (placementEditor && failure && "feedback" in failure) {
    const retry = failure.kind === "Uncertain"
      ? () => run(() => session.retryPlacements(placementEditor.mediaIds))
      : failure.kind === "LoadFailed"
        ? () => run(() => session.refreshPlacements(placementEditor.mediaIds))
        : null;
    placementError = { content: failure.feedback, onRetry: retry };
  }
  const changing = editorPlacements.find((placement) => placement?.kind === "Updating" || placement?.kind === "Queued");
  const pendingDestinationKey = changing?.kind === "Updating" || changing?.kind === "Queued"
    ? libraryPlacementDestinationKey(changing.command.destination) : null;
  const presented = new Map<LibraryPlacementDestinationKey, LibraryPlacementOption>();
  for (const placement of editorPlacements) {
    for (const option of placementLibraries(placement)) {
      if (placementEditor?.kind !== "Row") {
        const relation = placementEditor?.kind === "BulkAdd" ? "Absent" : "Direct";
        if (option.availability.kind !== "Available" || option.relation.kind !== relation) continue;
      }
      const key = libraryPlacementDestinationKey(option.destination);
      if (!presented.has(key)) presented.set(key, option);
    }
  }
  const placingMediaIds = new Set(operation?.kind === "Placement" ? operation.mediaIds : []);

  function editorContent() {
    if (!editor) return null;
    let title: string;
    if ("itemId" in editor) {
      const ownerIndex = state.items.findIndex((item) => item.id === editor.itemId);
      const owner = state.items[ownerIndex];
      if (!owner || owner.kind === "Insertion") return null;
      title = `libraries for item ${ownerIndex + 1}`;
    } else {
      title = editor.kind === "NewItems" ? "libraries for new items"
        : editor.kind === "DraftBulk" ? "libraries for editable items"
          : editor.kind === "BulkAdd" ? "add saved items to libraries"
            : "remove saved items from libraries";
    }
    if (placementEditor) {
      return (
        <LibraryChooserSurface
          key={placementEditor.kind === "Row" ? placementEditor.itemId : placementEditor.kind}
          active
          presentation={presentation}
          onClose={creatingDestination ? null : closeEditor}
          anchor={() => placementEditor.anchorEl}
          returnFocusFallback={() => headingRef.current}
          skipReturnFocus={() => returnFocusAnchor.current !== placementEditor.anchorEl}
          title={title}
          panelId={panelId}
          focusKey={placementEditor.anchorEl}
        >
          <LibraryEntryEditor
            placements={[...presented.values()]}
            loading={loadingPlacements}
            busy={busy}
            creating={creatingDestination}
            pendingDestinationKey={pendingDestinationKey}
            error={creationError ?? placementError}
            onToggle={(destination) => {
              const option = presented.get(libraryPlacementDestinationKey(destination));
              if (!option || option.relation.kind === "Inherited") return;
              setCreationError(null);
              const kind = option.relation.kind === "Absent" ? "Add" : "Remove";
              run(() => session.runPlacement({ mediaIds: placementEditor.mediaIds, command: { kind, destination } }));
            }}
            onCreateLibrary={placementEditor.kind === "BulkRemove" || editorPlacements.length === 0
              ? null : (name) => void createAndAdd(name, placementEditor.mediaIds)}
            selectedGroupLabel="In these libraries"
            otherGroupLabel="Other libraries"
            searchLabel="Search or create a library"
            searchPlaceholder="Search or create"
            listLabel="Library options"
            emptyInventory="No eligible libraries."
          />
        </LibraryChooserSurface>
      );
    }
    const draft = editor.kind === "Draft" ? drafts.find((item) => item.id === editor.itemId) : null;
    if (editor.kind === "Draft" && !draft) return null;
    return (
      <LibraryDestinationPicker
        key={editor.kind === "Draft" ? editor.itemId : editor.kind}
        open
        presentation={presentation}
        onClose={closeEditor}
        anchor={() => editor.anchorEl}
        skipReturnFocus={() => returnFocusAnchor.current !== editor.anchorEl}
        title={title}
        panelId={panelId}
        selectedGroupLabel="Selected libraries"
        interaction={interaction}
        onCreateDestination={createDestination}
        selection={editor.kind === "DraftBulk"
          ? { kind: "Bulk", entries: bulkEntries, onSet: session.setDraftLibrary }
          : {
              kind: "Item",
              selected: draft ? draft.destinations : state.newItemDestinations,
              onChange: (destinations) => draft
                ? session.setItemDestinations({ itemId: draft.id, destinations })
                : session.setNewItemDestinations({ destinations }),
            }}
      />
    );
  }

  function row(item: AddItem, index: number) {
    const source = item.kind === "Insertion" ? null : itemSource(item);
    const label = item.kind === "Insertion" ? "new item" : itemLabel(item);
    const editable = item.kind === "Insertion" || (item.kind === "Draft" && item.source.kind === "Url");
    const validation = validations.get(item.id);
    const feedback = item.kind === "Draft"
      ? item.showFeedback && validation?.kind === "Invalid" ? validation.feedback : null
      : item.kind === "Rejected" || item.kind === "AcceptanceUnresolved" ? item.feedback : null;
    const placementUncertain = item.kind === "Accepted" && hasUnconfirmedPlacement(state.placementByMediaId.get(item.result.mediaId));
    const feedbackId = feedback || placementUncertain ? `${id}-${item.id}-feedback` : undefined;
    const split = item.kind === "Draft" && item.source.kind === "Url" ? findAmbiguousUrlSplit(item.source.text) : null;
    const mediaId = item.kind === "Accepted" ? item.result.mediaId : null;
    const importRef = item.kind === "Accepted" ? item.result.importRef
      : "importRef" in item ? item.importRef : null;
    const status = itemStatus(item);
    const removable = item.kind === "Draft" || item.kind === "Rejected" || item.kind === "AcceptanceUnresolved";
    const rowEditor = editor && "itemId" in editor && editor.itemId === item.id;
    const seedEditor = editor?.kind === "NewItems" && item.kind === "Insertion";
    const fileKind = source?.kind === "File" ? "file" in source ? getFileUploadKind(source.file) : source.fileKind : null;
    const fileBytes = source?.kind === "File" ? "file" in source ? source.file.size : source.sizeBytes : null;
    const destinations = item.kind === "Draft" ? item.destinations
      : item.kind === "Insertion" ? state.newItemDestinations
        : item.kind !== "Accepted" ? item.intent.destinations : null;
    return (
      <article
        key={item.id}
        className={`${styles.row}${item.kind === "Insertion" ? ` ${styles.insertion}` : ""}`}
        data-add-item-id={item.id}
        aria-label={item.kind === "Insertion" ? "new item" : `item ${index + 1}`}
        aria-describedby={feedbackId}
      >
        <div className={styles.source}>
          {editable ? (
            <Input
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label={item.kind === "Insertion" ? "add a link" : `link for item ${index + 1}`}
              aria-invalid={feedback ? true : undefined}
              aria-describedby={feedbackId ?? `${id}-paste-help`}
              placeholder="paste links"
              value={item.kind === "Draft" && item.source.kind === "Url" ? item.source.text : ""}
              disabled={busy || (full && !isPopulatedAddItem(item))}
              className={styles.urlInput}
              onChange={(event) => {
                setAnnouncement(null);
                if (seedEditor && event.currentTarget.value !== "") closeEditorForSource();
                const origin = "inputType" in event.nativeEvent && event.nativeEvent.inputType === "insertFromPaste" ? "Paste" : "Typing";
                session.setItemUrl({ itemId: item.id, text: event.currentTarget.value, origin });
              }}
              onBlur={() => session.revealItemFeedback({ itemId: item.id })}
              onPaste={(event) => {
                const result = session.pasteUrls({
                  itemId: item.id,
                  text: event.clipboardData.getData("text/plain"),
                  selectionStart: event.currentTarget.selectionStart ?? 0,
                  selectionEnd: event.currentTarget.selectionEnd ?? 0,
                });
                if (result.kind === "Native") return;
                event.preventDefault();
                setAnnouncement(null);
                if (result.kind === "Applied" && result.focusItemId) {
                  if (rowEditor || seedEditor) closeEditorForSource();
                  focusSource(result.focusItemId);
                }
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                event.preventDefault();
                if (item.kind === "Insertion") return;
                if (full) {
                  setAnnouncement(`${MAX_ADD_ITEMS} items is the limit. remove an item to add another.`);
                  return;
                }
                const insertion = state.items.at(-1);
                if (insertion) {
                  if (rowEditor) closeEditorForSource();
                  focusSource(insertion.id);
                }
              }}
            />
          ) : (
            <div className={styles.sourceReceipt}>
              {source?.kind === "File" ? <FileText size={16} aria-hidden="true" /> : <Link size={16} aria-hidden="true" />}
              <span className={styles.sourceLabel} title={label}>{label}</span>
            </div>
          )}
          {fileBytes !== null ? (
            <span className={styles.itemStatus}>
              {fileKind?.toLowerCase() ?? "file"} · {fileBytes < 1024
                ? `${fileBytes} bytes`
                : fileBytes < 1024 ** 2
                  ? `${(fileBytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`
                  : `${(fileBytes / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`}
            </span>
          ) : null}
          {status ? <span className={styles.itemStatus}>{status}</span> : null}
          {mediaId && placingMediaIds.has(mediaId) ? <span className={styles.placementStatus}>updating libraries…</span> : null}
          {feedback ? <span id={feedbackId} className={styles.itemFeedback} data-tone={feedback.tone}>{feedbackStatus(feedback)}</span> : null}
          {placementUncertain ? <span id={feedbackId} className={styles.itemFeedback} data-tone="Warning">library changes unconfirmed</span> : null}
          {split ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.sourceAction}
              disabled={busy}
              onClick={() => {
                setAnnouncement(null);
                const result = session.splitItemUrl({ itemId: item.id });
                if (result.kind === "Applied" && result.focusItemId) {
                  if (rowEditor) closeEditorForSource();
                  focusSource(result.focusItemId);
                }
              }}
            >
              split into {pluralize(split.length, "link")}
            </Button>
          ) : null}
          {item.kind === "Rejected" || item.kind === "AcceptanceUnresolved" || mediaId || importRef !== null ? (
            <div className={styles.outcomeActions}>
              {item.kind === "AcceptanceUnresolved" ? (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => {
                  if (placementEditor) closeEditorForSource();
                  headingRef.current?.focus({ preventScroll: true });
                  run(() => session.reconcileAcceptance(item.id));
                }}>
                  {item.reason === "UploadIncomplete" ? "retry upload" : "check status"}
                </Button>
              ) : null}
              {item.kind === "Rejected" || item.kind === "AcceptanceUnresolved" ? (
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => {
                  session.restageItem(item.id);
                  if (source?.kind === "Url") focusSource(item.id);
                  else requestAnimationFrame(() => listRef.current
                    ?.querySelector<HTMLElement>(`[data-add-item-id="${item.id}"] button:not(:disabled)`)
                    ?.focus());
                }}>
                  {item.kind === "Rejected" ? "edit item" : "start a new attempt"}
                </Button>
              ) : null}
              {importRef !== null ? (
                <Button variant="ghost" size="sm" onClick={() => onOpen({
                  kind: "InternalHref",
                  href: `/imports?${encodeImportsUrl({ selected: importRef })}`,
                  secondaryActivation: { surfaceId: "import-detail" },
                })}>view import</Button>
              ) : null}
              {mediaId ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpen({ kind: "InternalHref", href: `/media/${mediaId}` })}>open</Button> : null}
            </div>
          ) : null}
        </div>
        <div className={styles.rowLibraries}>
          {item.kind === "Draft" || item.kind === "Insertion" ? (
            <LibraryDestinationTrigger
              label={item.kind === "Insertion" ? "for new items" : "libraries"}
              accessibleLabel={item.kind === "Insertion" ? "libraries for new items" : `libraries for ${label.trim() || `item ${index + 1}`}`}
              emptyLabel="choose"
              selected={item.kind === "Insertion" ? state.newItemDestinations : item.destinations}
              expanded={Boolean(rowEditor || seedEditor)}
              disabled={creatingDestination || (busy && !rowEditor && !seedEditor)}
              discloses={discloses}
              onToggle={(event) => toggleEditor(item.kind === "Insertion"
                ? { kind: "NewItems", anchorEl: event.currentTarget }
                : { kind: "Draft", itemId: item.id, anchorEl: event.currentTarget })}
            />
          ) : mediaId ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.libraryButton}
              disabled={creatingDestination || (busy && !rowEditor)}
              aria-label={`libraries for ${label}`}
              aria-expanded={Boolean(rowEditor)}
              aria-haspopup={mobile ? undefined : "dialog"}
              aria-controls={mobile ? panelId : undefined}
              onClick={(event) => toggleEditor({ kind: "Row", itemId: item.id, mediaIds: [mediaId], anchorEl: event.currentTarget })}
            >libraries…</Button>
          ) : <span className={styles.frozenLibraries} title={destinations?.map((destination) => destination.name).join(", ")}>{destinations?.map((destination) => destination.name).join(", ") || "—"}</span>}
        </div>
        <div className={styles.rowActions}>
          {removable ? (
            <Button variant="ghost" size="sm" iconOnly disabled={busy} onClick={() => removeItem(item.id)} aria-label={`remove ${label.trim() || `item ${index + 1}`}`}>
              <X size={16} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        {rowEditor || seedEditor ? <div className={styles.editorSlot}>{editorContent()}</div> : null}
      </article>
    );
  }

  const counts = [
    `${readyCount} ready`,
    attentionCount > 0 ? `${attentionCount} ${attentionCount === 1 ? "needs" : "need"} attention` : null,
    accepted.length > 0 ? `${accepted.length} saved` : null,
  ].filter(Boolean).join(" · ");
  const progress = operation ? mutationLabel({ operation, items: state.items }) : null;
  const liveStatus = announcement ?? (state.intakeFeedback
    ? feedbackStatus(state.intakeFeedback)
    : progress ?? counts);

  return (
    <div
      className={styles.panel}
      onDragEnter={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        dragDepthRef.current = 0;
        setDragActive(false);
        stageFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <header className={styles.header}>
        <div className={styles.headingRow}>
          <div className={styles.heading}>
            <h2 ref={headingRef} tabIndex={-1} data-add-heading="true">add content</h2>
            <p id={`${id}-paste-help`}>use line breaks or a comma and space. every item goes to All.</p>
          </div>
          <Button variant="ghost" size="sm" iconOnly onClick={onClose} aria-label="close add content"><X size={16} aria-hidden="true" /></Button>
        </div>
        <div className={styles.intakeTools}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.epub,application/pdf,application/epub+zip"
            className={styles.fileInput}
            aria-label="Choose PDF or EPUB files"
            disabled={busy || full}
            onChange={(event) => {
              stageFiles(Array.from(event.currentTarget.files ?? []));
              event.currentTarget.value = "";
              chooseFilesRef.current?.focus();
            }}
          />
          <Button ref={chooseFilesRef} variant="secondary" size="sm" disabled={busy} aria-disabled={full || undefined} leadingIcon={<Upload size={15} aria-hidden="true" />} onClick={() => {
            if (full) {
              setAnnouncement(`${MAX_ADD_ITEMS} items is the limit. remove an item to add another.`);
              return;
            }
            setAnnouncement(null);
            fileInputRef.current?.click();
          }}>choose files</Button>
          <span>or drop files · pdf up to 100 MiB · epub up to 50 MiB</span>
        </div>
        {accepted.length > 0 ? (
          <div className={styles.savedTools} aria-label="saved items">
            <span>saved items</span>
            {(["BulkAdd", "BulkRemove"] as const).map((kind) => (
              <Button
                key={kind}
                variant="ghost"
                size="sm"
                disabled={creatingDestination || (busy && editor?.kind !== kind)}
                aria-expanded={editor?.kind === kind}
                aria-haspopup={mobile ? undefined : "dialog"}
                aria-controls={mobile ? panelId : undefined}
                onClick={(event) => toggleEditor({ kind, mediaIds: acceptedMediaIds, anchorEl: event.currentTarget })}
              >{kind === "BulkAdd" ? "add to library…" : "remove from library…"}</Button>
            ))}
          </div>
        ) : null}
        <div className={styles.columnHeaders}>
          <span>source</span>
          <Button
            variant="ghost"
            size="sm"
            className={styles.libraryButton}
            disabled={creatingDestination || (busy && editor?.kind !== "DraftBulk")}
            aria-label="libraries for editable items"
            aria-describedby={`${id}-bulk-help`}
            aria-expanded={editor?.kind === "DraftBulk"}
            aria-haspopup={mobile ? undefined : "dialog"}
            aria-controls={mobile ? panelId : undefined}
            onClick={(event) => toggleEditor({ kind: "DraftBulk", anchorEl: event.currentTarget })}
          ><span className={styles.libraryButtonLabel}>{varies ? "varies by item" : "libraries"}<ChevronDown size={14} aria-hidden="true" /></span></Button>
        </div>
        <span className={styles.visuallyHidden} id={`${id}-bulk-help`}>applies to unsubmitted items and new items</span>
      </header>
      <div ref={listRef} className={`${styles.body}${dragActive ? ` ${styles.dragActive}` : ""}`}>
        {editor?.kind === "DraftBulk" || editor?.kind === "BulkAdd" || editor?.kind === "BulkRemove" ? <div className={styles.headerEditor}>{editorContent()}</div> : null}
        {state.intakeFeedback ? <p className={styles.intakeFeedback} data-tone={state.intakeFeedback.tone}>{feedbackStatus(state.intakeFeedback)}</p> : null}
        {state.items.map(row)}
      </div>
      <div className={styles.visuallyHidden} role="status" aria-live="polite">{liveStatus}</div>
      <footer className={styles.footer}>
        <p>{populatedCount > 0 ? counts : `up to ${MAX_ADD_ITEMS} items`}</p>
        <Button
          variant="primary"
          size="md"
          loading={busy}
          disabled={!busy && readyCount === 0 && !done}
          onClick={() => {
            if (busy) return;
            if (done) return onClose();
            if (readyCount === 0) return;
            if (placementEditor || (editor?.kind === "Draft" && validations.get(editor.itemId)?.kind === "Ready")) closeEditorForSource();
            headingRef.current?.focus({ preventScroll: true });
            setAnnouncement(null);
            run(session.submit);
          }}
        >{progress ?? (done ? "done" : readyCount > 0 ? `add ${pluralize(readyCount, "item")}` : "add items")}</Button>
      </footer>
      <AddDismissalDialog confirmation={dismissalConfirmation} onKeepWorking={onKeepWorking} onConfirm={onConfirmDismissal} keepWorkingRef={keepWorkingRef} />
    </div>
  );
}
