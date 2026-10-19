"use client";

import { useEffect, useId, useRef, useState, type Ref } from "react";
import { ChevronDown, FileText, Link, Upload, X } from "lucide-react";
import { FeedbackNotice, FeedbackStatus, FieldFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import PickerSurface from "@/components/ui/PickerSurface";
import DestinationChooser, { DestinationTrigger } from "@/components/libraries/DestinationChooser";
import PlacementOverlay from "@/components/libraries/PlacementOverlay";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { modeledApiError } from "@/lib/api/serverState";
import { savedSourceReadFailure } from "@/lib/imports/copy";
import { fetchAcceptedSource, getFileUploadKind, type AcceptedIngest } from "@/lib/imports/ingest";
import { encodeImportsUrl } from "@/lib/imports/query";
import type { LibraryDestination } from "@/lib/libraries/api";
import type { LibraryPlacementSession } from "@/lib/libraries/placementController";
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
  type DraftDestinationScope,
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

// Accepted items are filed through the shared "Libraries…" overlay: one row's,
// or every saved item's at once.
type Editor = (
  | { kind: "NewItems" | "DraftBulk" }
  | { kind: "Draft"; itemId: string }
  | { kind: "Row"; itemId: string; placement: LibraryPlacementSession }
  | { kind: "Saved"; placement: LibraryPlacementSession }
) & { anchorEl: HTMLElement };

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
  }
}

function isFileDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/** The session owns drafts and import receipts; shared placement owns saved items. */
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
  const creation = session.creation;
  const drafts = state.items.filter((item) => item.kind === "Draft");
  const validations = new Map(drafts.map((item) => [item.id, validateDraftSource(item.source)]));
  const populatedDrafts = drafts.filter(isPopulatedAddItem);
  const populatedCount = state.items.filter(isPopulatedAddItem).length;
  const full = populatedCount >= MAX_ADD_ITEMS;
  const readyCount = [...validations.values()].filter((result) => result.kind === "Ready").length;
  const accepted = state.items.filter((item) => item.kind === "Accepted");
  const attentionCount = [...validations.values()].filter((result) => result.kind === "Invalid").length
    + state.items.filter((item) => item.kind === "Rejected" || item.kind === "AcceptanceUnresolved").length;
  const done = accepted.length > 0 && accepted.length === populatedCount && session.leaveReason === null;
  const destinationSets = populatedDrafts.map((item) => item.destinations);
  const coverage = new Map<string, { destination: LibraryDestination; count: number }>();
  for (const destinations of destinationSets) {
    for (const destination of destinations) {
      coverage.set(destination.id, { destination, count: (coverage.get(destination.id)?.count ?? 0) + 1 });
    }
  }
  const entries = [...coverage.values()].map(({ destination, count }) => ({ destination, included: count }));
  const varies = entries.some(entry => entry.included < destinationSets.length);
  const [dragActive, setDragActive] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
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
  const discloses = mobile ? { kind: "region" as const, id: panelId } : { kind: "dialog" as const };
  const placementKey = useRef(0);
  const savedRead = useRef<AbortController | null>(null);
  const [checkingSaved, setCheckingSaved] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState<FeedbackContent | null>(null);

  useEffect(() => {
    if (dismissalConfirmation) requestAnimationFrame(() => keepWorkingRef.current?.focus());
  }, [dismissalConfirmation]);

  useEffect(() => {
    setCheckingSaved(false);
    setSavedFeedback(null);
    return () => {
      savedRead.current?.abort();
      savedRead.current = null;
    };
  }, [state.sessionId]);

  async function readSaved(
    results: readonly AcceptedIngest[],
    ready: (locations: readonly { mediaId: string; importRef: string; settled: boolean }[]) => void,
  ) {
    if (savedRead.current !== null) return;
    const controller = new AbortController();
    savedRead.current = controller;
    setCheckingSaved(true);
    setSavedFeedback(null);
    try {
      const locations = await Promise.all(results.map(async (result) => {
        if (result.sourceAttemptId === null)
          return { mediaId: result.mediaId, importRef: result.importRef, settled: true };
        const current = await fetchAcceptedSource(result.sourceAttemptId, controller.signal);
        return {
          mediaId: current.media_id,
          importRef: current.import_ref,
          settled: current.settled,
        };
      }));
      if (!controller.signal.aborted) ready(locations);
    } catch (error) {
      if (controller.signal.aborted) return;
      const failure = modeledApiError(error, ({ error: defect }) => onDefect(defect));
      if (failure !== null) setSavedFeedback(savedSourceReadFailure(failure));
    } finally {
      if (savedRead.current === controller) {
        savedRead.current = null;
        setCheckingSaved(false);
      }
    }
  }

  function placeSaved(results: readonly AcceptedIngest[], anchorEl: HTMLElement, itemId: string | null) {
    void readSaved(results, (locations) => {
      if (locations.some((location) => !location.settled)) {
        setSavedFeedback({ tone: "Neutral", title: "source is still processing",
          message: "your chosen libraries are already saved. change them here after processing finishes." });
        return;
      }
      const ids = [...new Set(locations.map((location) => location.mediaId))];
      const next = placement(ids, anchorEl);
      toggleEditor(itemId === null
        ? { kind: "Saved", placement: next, anchorEl }
        : { kind: "Row", itemId, placement: next, anchorEl });
    }).catch(onDefect);
  }

  function viewSavedImport(result: AcceptedIngest) {
    void readSaved([result], ([location]) => onOpen(location.settled ? {
      kind: "InternalHref",
      href: `/imports?${encodeImportsUrl({ selected: location.importRef })}`,
      secondaryActivation: { surfaceId: "import-detail" },
    } : {
      kind: "InternalHref",
      href: `/imports?${encodeImportsUrl({ view: "InProgress" })}`,
    })).catch(onDefect);
  }

  function run(command: () => Promise<void>) {
    setAnnouncement(null);
    void command().catch(onDefect);
  }
  function closeEditor() {
    setEditor(null);
  }
  function closeEditorForSource() {
    returnFocusAnchor.current = null;
    closeEditor();
  }
  function toggleEditor(next: Editor) {
    if (editor?.anchorEl === next.anchorEl) return closeEditor();
    if (busy && !("placement" in next)) return;
    returnFocusAnchor.current = next.anchorEl;
    setEditor(next);
  }
  /** A "Libraries…" session for some accepted media, anchored to its button. */
  function placement(mediaIds: readonly string[], anchorEl: HTMLElement): LibraryPlacementSession {
    placementKey.current += 1;
    return {
      key: placementKey.current,
      targets: mediaIds.map((mediaId) => ({ kind: "Media", id: mediaId })),
      options: { anchor: () => anchorEl, returnFocusFallback: () => headingRef.current },
    };
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
  const placementEditor = editor && "placement" in editor ? editor : null;

  function editorContent() {
    if (!editor) return null;
    let title: string;
    if ("itemId" in editor) {
      const ownerIndex = state.items.findIndex((item) => item.id === editor.itemId);
      const owner = state.items[ownerIndex];
      if (!owner || owner.kind === "Insertion") return null;
      title = `libraries for item ${ownerIndex + 1}`;
    } else {
      title = editor.kind === "NewItems" ? "libraries for new items" : "libraries for editable items";
    }
    if (placementEditor) {
      return (
        <PlacementOverlay
          session={placementEditor.placement}
          onClose={closeEditor}
          inline={mobile}
          panelId={panelId}
          skipReturnFocus={() => returnFocusAnchor.current !== placementEditor.anchorEl}
        />
      );
    }
    const draft = editor.kind === "Draft" ? drafts.find((item) => item.id === editor.itemId) : null;
    if (editor.kind === "Draft" && !draft) return null;
    const scope: DraftDestinationScope = {
      sessionId: state.sessionId,
      itemIds: editor.kind === "DraftBulk" ? populatedDrafts.map(item => item.id) : draft ? [draft.id] : [],
      includeNewItems: editor.kind === "NewItems",
    };
    return (
      <PickerSurface
        key={editor.kind === "Draft" ? editor.itemId : editor.kind}
        active
        inline={mobile}
        onClose={closeEditor}
        anchor={() => editor.anchorEl}
        returnFocusFallback={() => headingRef.current}
        skipReturnFocus={() => returnFocusAnchor.current !== editor.anchorEl}
        title={title}
        panelId={panelId}
      >
        <DestinationChooser
          selection={editor.kind === "DraftBulk" ? { kind: "Bulk", total: populatedDrafts.length, entries }
            : { kind: "Item", chosen: draft ? draft.destinations : state.newItemDestinations }}
          onSet={change => session.setLibrary({ scope, ...change })}
          create={{ available: !busy, pendingNames: creation.pendingNames, onCreate: name => creation.admit({
            name, scope: JSON.stringify({ ...scope, itemIds: scope.itemIds.toSorted() }),
            onCreated: destination => { session.setLibrary({ scope, destination, included: true }); },
          }) }}
          error={creation.error}
          status={creation.status}
          disabled={busy}
        />
      </PickerSurface>
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
    const feedbackId = feedback ? `${id}-${item.id}-feedback` : undefined;
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
          {status && feedback === null ? <FeedbackStatus content={{
            tone: item.kind === "AcceptanceUnresolved" ? "Warning" : item.kind === "Rejected" ? "Danger"
              : item.kind === "Accepted" ? item.result.processing === "failed" ? "Warning" : "Success" : "Neutral",
            title: status,
          }} announcement="None" /> : null}
          {feedback && feedbackId ? editable
            ? <FieldFeedback id={feedbackId} content={feedback} />
            : <div id={feedbackId}><FeedbackNotice content={feedback} announcement="None" /></div>
            : null}
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
                <Button variant="ghost" size="sm" disabled={checkingSaved} onClick={() => item.kind === "Accepted" ? viewSavedImport(item.result) : onOpen({
                  kind: "InternalHref",
                  href: `/imports?${encodeImportsUrl({ selected: importRef })}`,
                  secondaryActivation: { surfaceId: "import-detail" },
                })}>view import</Button>
              ) : null}
              {item.kind === "Accepted" ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => onOpen({ kind: "InternalHref", href: item.result.href })}>open</Button> : null}
            </div>
          ) : null}
        </div>
        <div className={styles.rowLibraries}>
          {item.kind === "Draft" || item.kind === "Insertion" ? (
            <DestinationTrigger
              label={item.kind === "Insertion" ? "for new items" : "libraries"}
              accessibleLabel={item.kind === "Insertion" ? "libraries for new items" : `libraries for ${label.trim() || `item ${index + 1}`}`}
              emptyLabel="choose"
              chosen={item.kind === "Insertion" ? state.newItemDestinations : item.destinations}
              expanded={Boolean(rowEditor || seedEditor)}
              disabled={busy && !rowEditor && !seedEditor}
              controls={discloses}
              onToggle={(event) => toggleEditor(item.kind === "Insertion"
                ? { kind: "NewItems", anchorEl: event.currentTarget }
                : { kind: "Draft", itemId: item.id, anchorEl: event.currentTarget })}
            />
          ) : mediaId ? (
            <Button
              variant="ghost"
              size="sm"
              className={styles.libraryButton}
              aria-label={`libraries for ${label}`}
              aria-expanded={Boolean(rowEditor)}
              aria-haspopup={mobile ? undefined : "dialog"}
              aria-controls={mobile ? panelId : undefined}
              disabled={checkingSaved}
              onClick={(event) => {
                if (item.kind === "Accepted") placeSaved([item.result], event.currentTarget, item.id);
              }}
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
    ? [state.intakeFeedback.title, state.intakeFeedback.message].filter(Boolean).join(" ")
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
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={editor?.kind === "Saved"}
              aria-haspopup={mobile ? undefined : "dialog"}
              aria-controls={mobile ? panelId : undefined}
              disabled={checkingSaved}
              onClick={(event) => placeSaved(accepted.map((item) => item.result), event.currentTarget, null)}
            >libraries for all…</Button>
          </div>
        ) : null}
        <div className={styles.columnHeaders}>
          <span>source</span>
          <Button
            variant="ghost"
            size="sm"
            className={styles.libraryButton}
            disabled={(busy || populatedDrafts.length === 0) && editor?.kind !== "DraftBulk"}
            aria-label="libraries for editable items"
            aria-describedby={`${id}-bulk-help`}
            aria-expanded={editor?.kind === "DraftBulk"}
            aria-haspopup={mobile ? undefined : "dialog"}
            aria-controls={mobile ? panelId : undefined}
            onClick={(event) => toggleEditor({ kind: "DraftBulk", anchorEl: event.currentTarget })}
          ><span className={styles.libraryButtonLabel}>{varies ? "varies by item" : "libraries"}<ChevronDown size={14} aria-hidden="true" /></span></Button>
        </div>
        <span className={styles.visuallyHidden} id={`${id}-bulk-help`}>applies to the current unsubmitted items; use for new items to change defaults</span>
      </header>
      {!editor || placementEditor ? <>
        {creation.status ? <FeedbackStatus content={{ tone: "Neutral", title: creation.status }} announcement="Polite" /> : null}
        {creation.error ? <FeedbackNotice content={creation.error.content} announcement="Assertive"
          actions={creation.error.retry ? [{ label: "retry", onClick: creation.error.retry, busy: creation.error.busy, commandKey: creation.error.commandKey }] : undefined} /> : null}
      </> : null}
      <div ref={listRef} className={`${styles.body}${dragActive ? ` ${styles.dragActive}` : ""}`}>
        {editor?.kind === "DraftBulk" || editor?.kind === "Saved" ? <div className={styles.headerEditor}>{editorContent()}</div> : null}
        {savedFeedback ? <div className={styles.intakeFeedback}><FeedbackNotice content={savedFeedback} announcement="Polite" /></div> : null}
        {state.intakeFeedback ? <div className={styles.intakeFeedback}><FeedbackNotice content={state.intakeFeedback} announcement="None" /></div> : null}
        {state.items.map(row)}
      </div>
      <div className={styles.visuallyHidden} role="status" aria-live="polite">{liveStatus}</div>
      <footer className={styles.footer}>
        <p>{populatedCount > 0 ? counts : `up to ${MAX_ADD_ITEMS} items`}</p>
        <Button
          variant="primary"
          size="md"
          loading={busy}
          disabled={creation.creating || (!busy && readyCount === 0 && !done)}
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
